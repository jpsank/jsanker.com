import { useState, useEffect } from 'react';
import { collection, addDoc, onSnapshot, orderBy, query, serverTimestamp, where } from "firebase/firestore";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db } from "../services/firebase";
import { Button, Card, Container } from 'react-bootstrap';
import ReactMarkdown from 'react-markdown';
import { compareDates, truncate } from "../utils/helper";
import Skeleton from 'react-loading-skeleton';
import { useAuth } from '../contexts/AuthContext';

const DEFAULT_CONTENT = `# Hello World

This is a blog post.`;


const Blogs = () => {
    const navigate = useNavigate();
    const params = useParams();
    const [blogs, setBlogs] = useState(null);
    const { currentUser } = useAuth();

    useEffect(() => {
        let q = query(
            collection(db, "blogs"),
            ...(params.authorId ? [where("authorId", "==", params.authorId)] : []),
            ...(params.search ? [where("content", ">=", params.search), where("content", "<=", params.search + "\uf8ff"), orderBy("content")] : []),
            orderBy("dateUpdated", "desc")
        );
        const unsubscribe = onSnapshot(q, (snapshot) => {
            if (snapshot.empty) {
                setBlogs([]);
                return;
            }
            const blogData = snapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data({ serverTimestamps: "estimate" }),
            }));
            setBlogs(blogData);
        });
        return () => unsubscribe();
    }, [params.authorId, params.search]);

    const createNewBlog = async (e) => {
        e.preventDefault();
        let blog = await addDoc(collection(db, "blogs"), {
            dateCreated: serverTimestamp(),
            dateUpdated: serverTimestamp(),
            content: DEFAULT_CONTENT,
            authorId: currentUser.uid,
            authorName: currentUser.displayName,
        });
        navigate(`/blogs/${blog.id}/edit`);
    };

    // const handleFormSubmit = (e) => {
    //     e.preventDefault();
    //     navigate(`/blogs/search/${e.target.search.value}`);
    // }

    return (
        <Container className="my-5 mx-sm-5 mx-0">
            <h1 className="mt-4">Blogs</h1>
            <p>This is where I write about things, and you can too! Sign up for an account to start writing. The markdown editor is powered by <a href="https://mdxeditor.dev/">MDXEditor</a> and the blogs and users are stored in <a href="https://firebase.google.com/docs/firestore">Cloud Firestore</a> and <a href="https://firebase.google.com/docs/auth">Firebase Auth</a>.</p>
            {/* <form className="d-flex" onSubmit={handleFormSubmit}>
                <input className="form-control me-2" name="search" id="search" type="search" placeholder="Search" aria-label="Search" />
                <button className="btn btn-outline-primary" type="submit">Search</button>
            </form> */}
            <div className="d-flex flex-column justify-content-center align-items-left">
                { currentUser && <Button onClick={createNewBlog}>Add a New Blog</Button> }
                { blogs === null ? <Skeleton count={5} height={150} /> : (
                    blogs.length === 0 ? <p>No blogs yet.</p> : blogs.map((blog) => (
                    <Card key={blog.id} className="my-3">
                        <Card.Body>
                            <Card.Subtitle className="mb-2 text-muted">
                                {blog.dateCreated.toDate().toLocaleDateString()} {compareDates(blog.dateCreated, blog.dateUpdated) !== 0 ? "(updated " + blog.dateUpdated.toDate().toLocaleDateString() + ")" : ""}
                                by <Link to={`/blogs/by/${blog.authorId}`}>{blog.authorName}</Link>
                            </Card.Subtitle>
                            <Card.Text as="div">
                                <Link to={"/blogs/" + blog.id} className="text-decoration-none text-black">
                                    <ReactMarkdown>
                                        {truncate(blog.content)}
                                    </ReactMarkdown>
                                </Link>
                            </Card.Text>
                        </Card.Body>
                    </Card>
                )))}
            </div>
        </Container>
    )
};

export default Blogs;
